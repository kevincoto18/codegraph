/** Pads a number to two digits. */
const pad = (value: number): string => String(value).padStart(2, '0');

/** Formats a date as DD/MM/YYYY. */
export default function formatDate(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear())}`;
}
