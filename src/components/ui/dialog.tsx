import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
}: {
  className?: string;
  children: ReactNode;
  title: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[min(100%-1.5rem,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-elevated p-5 shadow-pop",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <DialogPrimitive.Title className="font-display text-lg font-medium tracking-tight text-foreground">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close className="rounded-sm p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground">
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
