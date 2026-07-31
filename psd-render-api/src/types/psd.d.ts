/**
 * psd npm 包类型声明（该包未提供 .d.ts）
 */
declare module 'psd' {
  interface PsdLayerCoords {
    top: number;
    left: number;
    bottom: number;
    right: number;
  }

  interface PsdNode {
    name(): string;
    isGroup(): boolean;
    isText(): boolean;
    visible(): boolean;
    coords?: PsdLayerCoords;
    children(): PsdNode[];
    export(opts?: any): any;
    layer: any;
  }

  class PSD {
    static fromFile(path: string): PSD;
    parse(): void;
    tree(): PsdNode;
    header: { cols: number; rows: number };
  }

  export = PSD;
}
