// See src/shims/README — the real types drag lib.dom into a Worker project.
interface HljsLanguage {
  name?: string;
}
declare const hljs: {
  registerLanguage(name: string, definition: unknown): void;
  getLanguage(name: string): HljsLanguage | undefined;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
};
export default hljs;
