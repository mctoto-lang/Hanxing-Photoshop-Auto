/**
 * fontkit npm 包类型声明（该包未提供 .d.ts）
 * 仅声明本项目中使用到的 API，其余按 any 处理。
 *
 * 注意：fontkit v2.x 移除了 createSync，仅保留 create（同步返回 font 对象）。
 */
declare module 'fontkit' {
  export interface FontMetrics {
    familyName: string;
    postscriptName: string;
    style?: string;
    [key: string]: any;
  }

  // v2: create 是同步函数，直接返回 font 对象（非 Promise）
  export function create(buffer: Buffer, postscriptName?: string | null): FontMetrics;
  export function openSync(filename: string, postscriptName?: string | null): FontMetrics;
  export function open(filename: string, postscriptName?: string | null): Promise<FontMetrics>;

  const _default: {
    create: typeof create;
    openSync: typeof openSync;
    open: typeof open;
  };
  export default _default;
}
