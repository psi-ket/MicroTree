/**
 * Rotate the pairing token. Existing browser sessions stay valid until the
 * runtime restarts; remembered tokens in browsers stop working.
 */
import { loadConfig } from '../config';
import { loadOrCreatePairingToken } from '../security/tokens';

const config = loadConfig();
const token = await loadOrCreatePairingToken(config.dataDir, true);
console.info(`New pairing token written to ${config.dataDir}. Restart the runtime, then connect with:`);
console.info(`${config.webUrl}/#token=${token}`);
