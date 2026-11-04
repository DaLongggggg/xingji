import { nativeSearchAvailability, type NativeSearchMode } from "@/features/ai/native-search-contract";

export function WorkbenchNativeSearchStatus({ mode, modelSelected }: {
  mode?: NativeSearchMode;
  modelSelected: boolean;
}) {
  const availability = nativeSearchAvailability(mode);
  if (!modelSelected || availability.available) return null;
  return <p className="wb-model-state" data-ready={false} role="status">{availability.detail}</p>;
}
