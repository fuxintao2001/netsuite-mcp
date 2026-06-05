import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Open URL in default browser (cross-platform).
 * Uses execFile instead of exec to prevent command injection.
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      await execFileAsync('open', [url]);
    } else if (platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', url]);
    } else {
      await execFileAsync('xdg-open', [url]);
    }
    console.error('🌐 Browser opened automatically');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('⚠️  Could not auto-open browser:', message);
    console.error('   Please open the URL manually');
  }
}
