export interface FsNode {
  name: string;
  type: "file" | "dir";
  children?: FsNode[];
}

export interface JsDosCI {
  config: () => Promise<any>;
  height: () => number;
  width: () => number;
  screenshot: () => Promise<ImageData>;
  pause: () => void;
  resume: () => void;
  mute: () => void;
  unmute: () => void;
  exit: () => Promise<void>;
  sendBackendEvent: (event: any) => void;
  persist: (changesOnly?: boolean) => Promise<Uint8Array | null>;
  fsTree: () => Promise<FsNode>;
  fsReadFile: (file: string) => Promise<Uint8Array>;
  fsWriteFile: (
    file: string,
    contents: ReadableStream<Uint8Array> | Uint8Array,
  ) => Promise<void>;
  events: () => {
    onStdout: (consumer: (message: string) => void) => void;
    onFrameSize: (consumer: (width: number, height: number) => void) => void;
    onFrame: (
      consumer: (rgb: Uint8Array | null, rgba: Uint8Array | null) => void,
    ) => void;
    onSoundPush: (consumer: (samples: Float32Array) => void) => void;
    onExit: (fn: () => void) => void;
    onMessage: (consumer: (msgType: string, ...args: any[]) => void) => void;
    onUnload: (fn: () => Promise<void>) => void;
  };
}

export type DosEvent =
  | "emu-ready"
  | "ci-ready"
  | "bnd-play"
  | "open-key"
  | "fullscreen-change";

export type InitBundleEntry = Uint8Array;

export interface InitFileEntry {
  path: string;
  contents: Uint8Array;
}

export type InitFsEntry = InitBundleEntry | InitFileEntry;
export type InitFs = InitFsEntry | InitFsEntry[];

export interface JsDosFsChanges {
  local?: boolean;
  urlToKey?: (url: string) => Promise<string>;
  pull?: (key: string) => Promise<Uint8Array | null>;
  push?: (key: string, data: Uint8Array) => Promise<void>;
  delete?: (key: string) => Promise<void>;
}

export interface JsDosOptions {
  url: string;
  dosboxConf?: string;
  initFs?: InitFs;
  fsChanges?: JsDosFsChanges;
  theme?:
    | "light"
    | "dark"
    | "cupcake"
    | "bumblebee"
    | "emerald"
    | "corporate"
    | "synthwave"
    | "retro"
    | "cyberpunk"
    | "valentine"
    | "halloween"
    | "garden"
    | "forest"
    | "aqua"
    | "lofi"
    | "pastel"
    | "fantasy"
    | "wireframe"
    | "black"
    | "luxury"
    | "dracula"
    | "cmyk"
    | "autumn"
    | "business"
    | "acid"
    | "lemonade"
    | "night"
    | "coffee"
    | "winter";
  noSidebar?: boolean;
  autoStart?: boolean;
  fullScreen?: boolean;
  onEvent?: (event: DosEvent, arg?: any) => void;
  onExit?: () => void;
}

export interface DosProps {
  getVersion(): [string, string];
  setFullScreen(fullScreen: boolean): void;
  setAutoStart(autoStart: boolean): void;
  setAutoSave(autoSave: boolean): void;
  save(): Promise<boolean>;
  stop(): Promise<void>;
}

declare global {
  interface Window {
    Dos: (
      element: HTMLDivElement,
      options: Partial<JsDosOptions>,
    ) => DosProps;
  }
}

export {};
