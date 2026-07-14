/** Argv equality for approved verification commands. */
export function sameCommand(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
