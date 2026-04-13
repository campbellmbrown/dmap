import os from "node:os";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  if (LOOPBACK_ADDRESSES.has(address)) {
    return true;
  }

  if (address.startsWith("::ffff:")) {
    return LOOPBACK_ADDRESSES.has(address.replace("::ffff:", ""));
  }

  return false;
}

function isPrivateIPv4(address: string): boolean {
  if (address.startsWith("10.")) {
    return true;
  }

  if (address.startsWith("192.168.")) {
    return true;
  }

  const secondOctet = Number(address.split(".")[1]);
  return address.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31;
}

export function getLanAddress(): string {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }

      if (isPrivateIPv4(entry.address)) {
        return entry.address;
      }
    }
  }

  return "127.0.0.1";
}
