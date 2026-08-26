import { CursorSelection, InAppKeys, ShortcutManager } from "./components";
import { PageLayout } from "@/layouts";

const Shortcuts = () => {
  return (
    <PageLayout
      title="Cursor & Keyboard Shortcuts"
      description="Manage your cursor and keyboard shortcuts"
    >
      <div className="flex flex-col gap-6 pb-8">
        {/* Cursor Selection */}
        <CursorSelection />

        {/* Keyboard Shortcuts */}
        <ShortcutManager />

        {/* Keys the HUD handles itself, which are fixed and were undocumented */}
        <InAppKeys />
      </div>
    </PageLayout>
  );
};

export default Shortcuts;
