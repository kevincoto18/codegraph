/** Logs an informational message. */
export function info(message: string): void {
  write('INFO', message);
}

/** Logs a warning. */
export function warn(message: string): void {
  write('WARN', message);
}

/** Writes a formatted line to the console. */
function write(level: string, message: string): void {
  console.log(`[${level}] ${message}`);
}
