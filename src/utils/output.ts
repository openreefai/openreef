import chalk from 'chalk';

export const icons = {
  success: chalk.green('\u2714'),
  error: chalk.red('\u2716'),
  warning: chalk.yellow('\u26A0'),
  info: chalk.blue('\u2139'),
};

export function header(text: string): string {
  return chalk.bold.underline(text);
}

export function label(text: string): string {
  return chalk.dim(text);
}

export function value(text: string): string {
  return chalk.cyan(text);
}

export function table(rows: string[][], columnGap = 2): string {
  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];

  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(...rows.map((r) => (r[c] ?? '').length));
  }

  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i < row.length - 1 ? cell.padEnd(widths[i] + columnGap) : cell,
        )
        .join(''),
    )
    .join('\n');
}
