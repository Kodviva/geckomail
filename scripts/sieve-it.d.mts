export function gateError(o: { host: string; users: string[] }): string | null
export interface AuthGuard {
  readonly rejected: boolean
  run<T>(login: () => Promise<T>): Promise<T>
}
export function authGuard(): AuthGuard
