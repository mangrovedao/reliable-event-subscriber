import { createConsoleLogger, logdataLimiter } from "@mangrovedao/commonlib.js";

let loggingEnabled = false;
export function enableLogging(): void {
  loggingEnabled = true;
}
export function disableLogging(): void {
  loggingEnabled = false;
}

const logLevel = process.env['LOG_LEVEL'] ? process.env['LOG_LEVEL'] : 'info';
export const logger = createConsoleLogger(() => loggingEnabled, logLevel);

export default logger;
export { logdataLimiter };
