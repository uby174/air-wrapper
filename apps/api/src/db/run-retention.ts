import { runRetentionCleanup } from './privacy';

const run = async (): Promise<void> => {
  const outcome = await runRetentionCleanup();
  console.log('Retention cleanup completed:', outcome);
};

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Retention cleanup failed:', error);
    process.exit(1);
  });
