export async function lock(_identifier: string): Promise<void> {
  console.error('reef lock requires ClawHub, which is not yet available.');
  process.exit(1);
}
