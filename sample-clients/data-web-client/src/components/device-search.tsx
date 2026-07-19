'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';

interface Device {
  deviceId: string;
  lastSeen: string;
}

export function DeviceSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);

  const load = () => {
    fetch('/api/devices')
      .then((r) => r.json() as Promise<{ devices: Device[] }>)
      .then((d) => setDevices(d.devices ?? []))
      .catch(() => setDevices([]));
  };

  const openDialog = () => {
    load();
    setOpen(true);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}>
        Search devices…
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command>
          <CommandInput
            placeholder="Search devices…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No devices found.</CommandEmpty>
            <CommandGroup heading="Devices">
              {devices
                .filter((d) => d.deviceId.toLowerCase().includes(query.toLowerCase()))
                .map((d) => (
                  <CommandItem
                    key={d.deviceId}
                    value={d.deviceId}
                    onSelect={() => {
                      setOpen(false);
                      router.push(`/device/${d.deviceId}`);
                    }}
                  >
                    {d.deviceId}
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
