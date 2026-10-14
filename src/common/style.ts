/** Terminal colors via node:util styleText. Honors NO_COLOR and FORCE_COLOR; off when stdout is not a TTY. */

import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];

function detect(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return Boolean(process.stdout.isTTY);
}

let enabled = detect();

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

const paint =
  (format: Format) =>
  (text: string): string =>
    enabled ? styleText(format, text, { validateStream: false }) : text;

export const style = {
  bold: paint('bold'),
  dim: paint('dim'),
  red: paint('red'),
  green: paint('green'),
  yellow: paint('yellow'),
  cyan: paint('cyan'),
  redBold: paint(['red', 'bold']),
};
