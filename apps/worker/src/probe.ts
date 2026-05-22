import { SuwayomiClient, SuwayomiSource, UnknownSourceError } from '@manhwa/sources';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: pnpm worker:probe <manga-url>');
    process.exit(1);
  }

  const suwayomiUrl = process.env.SUWAYOMI_URL;
  if (!suwayomiUrl) {
    console.error('SUWAYOMI_URL is not set. Check your .env.local.');
    process.exit(1);
  }

  const client = new SuwayomiClient(suwayomiUrl);
  const source = new SuwayomiSource(client);

  if (!source.matches(url)) {
    console.error(`No source adapter matches URL: ${url}`);
    console.error('Supported hosts:');
    const { SOURCE_REGISTRY } = await import('@manhwa/sources');
    for (const entry of SOURCE_REGISTRY) {
      console.error(`  - ${entry.extensionName}: ${entry.hosts.join(', ')}`);
    }
    process.exit(2);
  }

  try {
    const resolved = await source.resolve(url);
    console.log(JSON.stringify(resolved, null, 2));
  } catch (err) {
    if (err instanceof UnknownSourceError) {
      console.error('UnknownSourceError:', err.message);
      process.exit(2);
    }
    console.error('Resolve failed:', err);
    process.exit(3);
  }
}

main();
