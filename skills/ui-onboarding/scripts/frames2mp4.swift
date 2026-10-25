// Reads a stream of PNG frames on stdin and writes an H.264 MP4 that phones play:
// yuv 4:2:0 via the hardware encoder, the moov atom up front (network-optimized),
// constant frame rate. Uses only AVFoundation, so no ffmpeg with x264 is needed.
//
//   ffmpeg-mac -i in.webm -f image2pipe -c:v png - | swift frames2mp4.swift out.mp4 25 6000000
//
// Prints the written duration, frame count and codec, so the caller can check the
// result instead of trusting the exit code.
import AVFoundation
import CoreImage
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count >= 3, let fps = Int32(args[2]) else {
  FileHandle.standardError.write("usage: frames2mp4.swift <out.mp4> <fps> [bitrate]\n".data(using: .utf8)!)
  exit(64)
}
let outURL = URL(fileURLWithPath: args[1])
let bitrate = args.count > 3 ? Int(args[3]) ?? 6_000_000 : 6_000_000
try? FileManager.default.removeItem(at: outURL)

let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
let iend: [UInt8] = [0x49, 0x45, 0x4E, 0x44]  // "IEND", followed by a 4-byte CRC

var writer: AVAssetWriter?
var input: AVAssetWriterInput?
var adaptor: AVAssetWriterInputPixelBufferAdaptor?
var frames: Int64 = 0
let ci = CIContext(options: [.useSoftwareRenderer: false])

func start(width: Int, height: Int) throws {
  let w = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
  w.shouldOptimizeForNetworkUse = true
  let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width - width % 2,
    AVVideoHeightKey: height - height % 2,
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
    ],
  ]
  let i = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
  i.expectsMediaDataInRealTime = false
  let a = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: i, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width - width % 2,
    kCVPixelBufferHeightKey as String: height - height % 2,
  ])
  w.add(i)
  guard w.startWriting() else { throw w.error ?? NSError(domain: "frames2mp4", code: 1) }
  w.startSession(atSourceTime: .zero)
  writer = w; input = i; adaptor = a
}

func append(png: Data) throws {
  guard let src = CGImageSourceCreateWithData(png as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return }
  if writer == nil { try start(width: image.width, height: image.height) }
  guard let a = adaptor, let i = input, let pool = a.pixelBufferPool else { return }
  var buffer: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
  guard let pb = buffer else { return }
  ci.render(CIImage(cgImage: image), to: pb)
  while !i.isReadyForMoreMediaData { usleep(2_000) }
  if !a.append(pb, withPresentationTime: CMTime(value: frames, timescale: fps)) {
    throw writer?.error ?? NSError(domain: "frames2mp4", code: 2)
  }
  frames += 1
}

// Split the stdin stream into whole PNG files: each ends 4 bytes after "IEND".
var pending = Data()
let stdin = FileHandle.standardInput
while true {
  let chunk = stdin.readData(ofLength: 1 << 20)
  if chunk.isEmpty { break }
  pending.append(chunk)
  while let end = pending.range(of: Data(iend)) {
    let stop = end.upperBound + 4
    guard stop <= pending.count else { break }
    let png = pending.subdata(in: pending.startIndex..<stop)
    pending.removeSubrange(pending.startIndex..<stop)
    guard png.starts(with: signature) else { continue }
    try append(png: png)
  }
}

guard let w = writer, let i = input else {
  FileHandle.standardError.write("no frames on stdin\n".data(using: .utf8)!)
  exit(65)
}
i.markAsFinished()
let done = DispatchSemaphore(value: 0)
w.finishWriting { done.signal() }
done.wait()
if w.status != .completed {
  FileHandle.standardError.write("writer failed: \(String(describing: w.error))\n".data(using: .utf8)!)
  exit(70)
}
let asset = AVURLAsset(url: outURL)
let seconds = CMTimeGetSeconds(asset.duration)
print(String(format: "mp4 %@ frames=%lld duration=%.2fs fps=%d codec=avc1", outURL.path, frames, seconds, fps))
