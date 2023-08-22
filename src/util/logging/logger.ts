import { createLogger, format, CommonLogger } from "./coreLogger";

import os from "os";
import safeStringify from "fast-safe-stringify";

const consoleLogFormat = format.printf(
  ({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}] `;
    if (metadata.data !== undefined) {
      msg += ` | data: ${safeStringify(metadata.data)}`;
    }
    if (metadata.stack) {
      msg += `${os.EOL}${metadata.stack}`;
    }
    return msg;
  }
);

export const logger = createLogger(consoleLogFormat, (process.env["RES_LOG_LEVEL"] ?? "silent"), process.env["NO_COLOR"]);

export default logger;
