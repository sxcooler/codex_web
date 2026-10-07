// Native item lifecycle timestamps use Unix milliseconds, unlike turn timestamps.
export const validItemTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

export function itemWithTimes(item: any, timing: any = {}, previous: any = {}): any {
  const result = structuredClone(item);
  for (const field of ['startedAtMs', 'completedAtMs']) {
    const value = [timing[field], item[field], previous?.[field]].find(validItemTime);
    if (value !== undefined) result[field] = value;
    else delete result[field];
  }
  return result;
}
