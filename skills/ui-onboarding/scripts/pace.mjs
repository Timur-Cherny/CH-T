// One definition of pace for both linters: steps per minute of step time. Intro, chapter cards
// and the recap are pauses between tasks; counting them would hide a rushed walkthrough.
export const MAX_STEPS_PER_MIN = 7;
export const stepsPerMinute = (steps, stepMs) => steps / Math.max(stepMs / 60000, 0.01);
