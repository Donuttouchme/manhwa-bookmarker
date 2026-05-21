async function main() {
  console.log('[worker] stub — populated in Plan 3 (pg-boss polling).');
  console.log('[worker] DB URL set:', Boolean(process.env.DATABASE_URL));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
