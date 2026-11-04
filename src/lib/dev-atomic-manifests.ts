import { randomUUID } from "node:crypto";
import type { webpack } from "next/dist/compiled/webpack/webpack";

type Done = (error?: NodeJS.ErrnoException | null) => void;
type OutputFiles = {
  writeFile(path: string, bytes: string | Uint8Array, done: Done): void;
  rename(from: string, to: string, done: Done): void;
  unlink(path: string, done: Done): void;
};
const installed = new WeakSet<object>();

/** Dev requests can read shared manifests while another compiler is emitting them. */
export class DevAtomicManifestsPlugin {
  apply(compiler: webpack.Compiler): void {
    const output = compiler.outputFileSystem as OutputFiles | null;
    if (!output || typeof output.rename !== "function" || typeof output.unlink !== "function") {
      throw new Error("Dev manifest output requires rename and unlink support.");
    }
    if (installed.has(output)) return;
    installed.add(output);
    const write = output.writeFile.bind(output);
    output.writeFile = (file, bytes, done) => {
      if (!/(?:^|[/\\])[^/\\]*manifest\.json$/.test(file)) return write(file, bytes, done);
      const temporary = `${file}.tmp-${randomUUID()}`;
      const finish = (error?: NodeJS.ErrnoException | null) => {
        if (error) output.unlink(temporary, () => done(error));
        else done();
      };
      write(temporary, bytes, error => {
        if (error) finish(error);
        else output.rename(temporary, file, finish);
      });
    };
  }
}
