import { useCompletion } from "@/hooks";
import { Screenshot } from "./Screenshot";
import { Files } from "./Files";
import { Input } from "./Input";

export const Completion = ({ isHidden }: { isHidden: boolean }) => {
  const completion = useCompletion();

  return (
    <>
      <Input {...completion} isHidden={isHidden} />
      <div className="hidden" aria-hidden="true">
        <Screenshot {...completion} />
        <Files {...completion} />
      </div>
    </>
  );
};

export { QuickModelSwitcher } from "./QuickModelSwitcher";
