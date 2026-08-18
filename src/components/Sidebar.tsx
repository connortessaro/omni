import { Button, OmniLogo } from "@/components";
import { cn } from "@/lib/utils";
import { useLocation, useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMenuItems, useVersion } from "@/hooks";

export const Sidebar = () => {
  const { version, isLoading } = useVersion();
  const { menu, footerLinks, footerItems } = useMenuItems();

  const navigate = useNavigate();
  const activeRoute = useLocation().pathname;
  return (
    <aside className="flex w-60 flex-col select-none pt-2 border-r border-border/40 bg-sidebar/50 backdrop-blur-xl">
      {/* Logo & Brand Header */}
      <div
        onClick={() => navigate("/dashboard")}
        className="flex h-16 items-center px-4 pt-10 gap-3 cursor-pointer group"
      >
        <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 via-primary/10 to-transparent border border-primary/30 shadow-sm shadow-primary/10 transition-all duration-300 group-hover:border-primary/60 group-hover:shadow-primary/20">
          <OmniLogo size={22} glow={false} />
        </div>
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <h1 className="text-base font-bold bg-gradient-to-r from-foreground via-foreground to-foreground/80 bg-clip-text text-transparent tracking-tight transition-all duration-300 group-hover:text-primary">
              Omni
            </h1>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-primary/10 text-primary border border-primary/20">
              v1
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground/70 -mt-0.5 block">
            {isLoading ? "Loading..." : `v${version}`}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-6">
        {menu.map((item, index) => (
          <button
            onClick={() => navigate(item.href)}
            key={`${item.label}-${index}`}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs lg:text-sm text-sidebar-foreground/70 transition-all duration-300 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              activeRoute.includes(item.href)
                ? "font-medium bg-sidebar-accent text-sidebar-accent-foreground"
                : ""
            )}
          >
            <div className="flex items-center gap-3">
              <item.icon className="size-3 lg:size-4 transition-all duration-300" />
              {item.label}
            </div>
            {item.count ? (
              <span className="flex size-5 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                {item.count}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="flex flex-col space-y-1 px-3  pb-3">
        <div className="flex flex-row justify-evenly items-center gap-2 mb-3">
          {footerLinks.map((item, index) => (
            <Button
              key={`${item.title}-${index}`}
              title={item.title}
              size="sm"
              variant="outline"
              onClick={() => openUrl(item.link)}
            >
              <item.icon className="size-3 lg:size-4 transition-all duration-300" />
            </Button>
          ))}
        </div>

        {footerItems.map((item, index) =>
          item.href ? (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              key={`${item.label}-${index}`}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs lg:text-sm text-sidebar-foreground/70 transition-all duration-300 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <div className="flex items-center gap-3">
                <item.icon className="size-3 lg:size-4 transition-all duration-300" />
                {item.label}
              </div>
            </a>
          ) : (
            <button
              onClick={item.action}
              type="button"
              key={`${item.label}-${index}`}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs lg:text-sm text-sidebar-foreground/70 transition-all duration-300 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer"
              )}
            >
              <div className="flex items-center gap-3">
                <item.icon className="size-3 lg:size-4 transition-all duration-300" />
                {item.label}
              </div>
            </button>
          )
        )}
      </div>
    </aside>
  );
};
