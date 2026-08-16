import bcrypt from 'bcryptjs';

async function main(): Promise<void> {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: hash-password <password>');
    process.exitCode = 1;
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
