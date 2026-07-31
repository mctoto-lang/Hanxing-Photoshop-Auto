const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    // Check storage config from DB
    const config = await p.storageConfig.findFirst();
    console.log('STORAGE CONFIG:', JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await p.$disconnect();
  }
})();
