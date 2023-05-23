
interface ILogger {
  info(...objs: any): void;
  debug(...objs: any): void;
  trace(...objs: any): void;
  warn(...objs: any): void;
  error(...objs: any): void;
}

let _logger: ILogger | undefined;

export const enableLogging = (logger: ILogger) => {
  _logger = logger;
}


export const defaultLogger = {
  info: (...objs: any): void => {
    console.log('[info]', ...objs)
  }, 

  debug: (...objs: any): void => {
    console.log('[debug]', ...objs)
  }, 

  trace: (...objs: any): void => {
    console.log('[trace]', ...objs)
  }, 

  warn: (...objs: any): void => {
    console.log('[warn]', ...objs)
  }, 

  error: (...objs: any): void => {
    console.log('[errror]', ...objs)
  },    
}

export default {
  info: (...objs: any): void => {
    if (_logger) _logger.info(...objs);
  }, 

  debug: (...objs: any): void => {
    if (_logger) _logger.debug(...objs);
  }, 

  trace: (...objs: any): void => {
    if (_logger) _logger.trace(...objs);
  }, 

  warn: (...objs: any): void => {
    if (_logger) _logger.warn(...objs);
  }, 

  error: (...objs: any): void => {
    if (_logger) _logger.error(...objs);
  },     
}
