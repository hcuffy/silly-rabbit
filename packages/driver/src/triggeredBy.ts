import { userInfo } from "node:os";

export function getTriggeredBy(getUserInfo: () => { username: string } = userInfo): string {
  return getUserInfo().username;
}
