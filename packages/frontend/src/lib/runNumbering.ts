export function computeRunNumber(offset: number, indexInPage: number): number {
  return offset + indexInPage + 1;
}
