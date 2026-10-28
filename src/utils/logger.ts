/**
 * ログ。stdio トランスポートでは stdout が JSON-RPC の線なので、すべて stderr に書く。
 */
export const logger = {
  debug(context: string, message: string): void {
    if (process.env.DEBUG) console.error(`[${context}] ${message}`);
  },
  info(context: string, message: string): void {
    console.error(`[${context}] ${message}`);
  },
  warn(context: string, message: string): void {
    console.error(`[${context}] ${message}`);
  },
  error(context: string, message: string, error?: Error): void {
    console.error(`[${context}] ${message}`);
    if (error && process.env.DEBUG) console.error(error.stack);
  },
};
