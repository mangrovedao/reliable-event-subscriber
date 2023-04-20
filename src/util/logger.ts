import { createConsoleLogger, logdataLimiter } from "@mangrovedao/commonlib.js";

let loggingEnabled = false;
export function enableLogging(): void {
  loggingEnabled = true;
}
export function disableLogging(): void {
  loggingEnabled = false;
}

const logLevel = "info";
export const logger = createConsoleLogger(() => loggingEnabled, logLevel);

export default logger;
export { logdataLimiter };
