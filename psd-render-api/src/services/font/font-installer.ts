/**
 * 字体安装器：将字体文件安装到 Windows 系统
 *
 * 逻辑复用自 psd-render-worker/src/worker/font-sync.ts，供 API 服务器上传字体时立即安装。
 *
 * 安装位置：C:\Windows\Fonts
 * 注册位置：HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts
 * 通知机制：SendMessageTimeout(WM_FONTCHANGE) 广播字体变更
 *
 * 权限注意：字体安装到 C:\Windows\Fonts 需要管理员权限。
 * 若 API 服务器未以管理员身份运行，安装会失败但不抛错（仅记录警告），
 * 字体仍会写入 DB，Worker 空闲同步时会重新尝试安装。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../../lib/logger.js';

export interface InstallResult {
  installed: boolean;
  reason?: 'exists' | 'success' | 'permission_denied' | 'error';
  message?: string;
}

export class FontInstaller {
  /**
   * 安装字体文件到系统
   * @param fontFilePath 字体文件本地路径（.ttf/.otf/.ttc）
   * @returns 安装结果
   *
   * P0 安全修复（低危15）：对 fontName 增加白名单校验，防止未来 fileObjectKey
   *   来源变化时引入 PowerShell 命令注入。当前 fontService 已做 safeName 过滤，
   *   此处为防御性校验。
   */
  async install(fontFilePath: string): Promise<InstallResult> {
    const fontName = path.basename(fontFilePath);
    if (!fs.existsSync(fontFilePath)) {
      return { installed: false, reason: 'error', message: `字体文件不存在: ${fontFilePath}` };
    }
    // P0：fontName 白名单校验——只允许字母、数字、点、下划线、连字符
    if (!/^[a-zA-Z0-9._-]+$/.test(fontName)) {
      return {
        installed: false,
        reason: 'error',
        message: `字体文件名包含不安全字符: ${fontName}（仅允许字母、数字、点、下划线、连字符）`,
      };
    }

    const script = this.buildInstallScript(fontFilePath, fontName);
    try {
      const output = await this.runPowerShell(script, 15_000);
      if (output.includes('EXISTS')) {
        return { installed: true, reason: 'exists' };
      }
      if (output.includes('INSTALLED')) {
        logger.info({ fontName, msg: '字体已安装到系统' });
        return { installed: true, reason: 'success' };
      }
      if (output.includes('ERR:')) {
        const errMsg = output.split('ERR:')[1]?.trim() ?? '未知错误';
        logger.warn({ fontName, msg: '字体安装失败', err: errMsg });
        return { installed: false, reason: 'error', message: errMsg };
      }
      return { installed: false, reason: 'error', message: output.trim() };
    } catch (e) {
      const msg = (e as Error).message;
      // 权限不足通常表现为"拒绝访问"或"注册表写入失败"
      const isPermission = /denied|access|权限|拒绝|registry|注册表/i.test(msg);
      logger.warn({
        fontName,
        msg: isPermission ? '字体安装失败（可能缺少管理员权限）' : '字体安装失败',
        err: msg,
      });
      return {
        installed: false,
        reason: isPermission ? 'permission_denied' : 'error',
        message: msg,
      };
    }
  }

  /**
   * 卸载字体（删除字体文件 + 注册表项）
   * 仅在字体未被任何绑定引用时调用
   *
   * P0 安全修复（低危15）：fontFileName 来自 path.basename(fileObjectKey)，
   *   虽然当前 fileObjectKey 末段来自 fontService 的 safeName 过滤，但此处
   *   增加防御性白名单校验，防止未来 fileObjectKey 来源变化引入命令注入。
   */
  async uninstall(fontFileName: string): Promise<boolean> {
    // P0：白名单校验——只允许字母、数字、点、下划线、连字符
    if (!/^[a-zA-Z0-9._-]+$/.test(fontFileName)) {
      logger.warn({
        fontFileName,
        msg: '字体卸载跳过：文件名包含不安全字符',
      });
      return false;
    }
    const script = this.buildUninstallScript(fontFileName);
    try {
      await this.runPowerShell(script, 10_000);
      logger.info({ fontFileName, msg: '字体已从系统卸载' });
      return true;
    } catch (e) {
      logger.warn({ fontFileName, msg: '字体卸载失败', err: (e as Error).message });
      return false;
    }
  }

  private buildInstallScript(fontFilePath: string, fontName: string): string {
    const src = fontFilePath.replace(/'/g, "''").replace(/\\/g, '\\\\');
    const dstName = fontName.replace(/'/g, "''");
    return `
$ErrorActionPreference = 'Stop'
$src = '${src}'
$dst = Join-Path $env:WINDIR 'Fonts\\${dstName}'
if (Test-Path $dst) { Write-Output 'EXISTS'; exit 0 }
try {
  Copy-Item $src $dst -Force
  # 注册到注册表
  $name = '${dstName}'
  New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name $name -PropertyType String -Value $dst -Force | Out-Null
  # 通知系统字体变化
  Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern int SendMessageTimeout(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam, int fuFlags, int uTimeout, out IntPtr lpdwResult);
  '
  $HWND_BROADCAST = [IntPtr]0xffff
  $WM_FONTCHANGE = 0x001D
  $result = [IntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_FONTCHANGE, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
  Write-Output 'INSTALLED'
} catch {
  Write-Output "ERR:$($_.Exception.Message)"
  exit 1
}
`;
  }

  private buildUninstallScript(fontFileName: string): string {
    const name = fontFileName.replace(/'/g, "''");
    return `
$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:WINDIR 'Fonts\\${name}'
try {
  if (Test-Path $dst) { Remove-Item $dst -Force }
  Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name '${name}' -ErrorAction SilentlyContinue
  # 通知系统字体变化
  Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern int SendMessageTimeout(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam, int fuFlags, int uTimeout, out IntPtr lpdwResult);
  ' -ErrorAction SilentlyContinue
  $HWND_BROADCAST = [IntPtr]0xffff
  $WM_FONTCHANGE = 0x001D
  $result = [IntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_FONTCHANGE, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
  Write-Output 'UNINSTALLED'
} catch {
  Write-Output "ERR:$($_.Exception.Message)"
  exit 1
}
`;
  }

  private runPowerShell(script: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', script,
      ], { windowsHide: true });
      let stdout = '';
      ps.stdout.on('data', (d) => { stdout += d.toString(); });
      const timer = setTimeout(() => { ps.kill(); reject(new Error('超时')); }, timeoutMs);
      ps.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`退出码 ${code}: ${stdout}`));
      });
      ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
}

export const fontInstaller = new FontInstaller();
