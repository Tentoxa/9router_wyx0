#!/usr/bin/env python3
"""
Remove known-bad proxies from proxy list based on log analysis.

Bad proxies identified from wyxrouter_logs.txt (5000 lines):
- 8 proxies with 100% failure rates
- 82.22.234.x subnet (65% failure rate)
- 138.128.148.x subnet (100% failure rate)
"""
from pathlib import Path
import sys

# Proxies with 100% failure rates
BAD_PROXIES = {
    "82.22.234.151:8001",
    "31.58.9.61:6134",
    "31.58.9.52:6125",
    "31.58.9.144:6217",
    "31.58.9.133:6206",
    "194.113.119.93:6767",
    "138.128.148.3:6563",
    "138.128.148.101:6661",
}

# Problematic subnets (remove all proxies in these ranges)
BAD_SUBNETS = [
    "82.22.234.",   # 65% failure rate
    "138.128.148.", # 100% failure rate
]

# Also remove high-failure individual proxies
HIGH_FAILURE_PROXIES = {
    "82.22.234.251:8101",  # 57% failure rate
    "45.117.55.98:6744",   # 67% failure rate
    "45.117.55.246:6892",  # 67% failure rate
    "45.117.55.228:6874",  # 67% failure rate
    "31.58.24.67:6138",    # 67% failure rate
    "45.117.55.247:6893",  # 100% failure rate (only 2 attempts)
}

def should_remove_proxy(line):
    """Check if proxy should be removed based on known bad IPs/subnets."""
    # Extract IP:port from line (format: http://user:pass@ip:port or ip:port)
    proxy_addr = line.strip()

    # Remove protocol prefix if present
    if "://" in proxy_addr:
        proxy_addr = proxy_addr.split("://", 1)[1]

    # Remove auth if present
    if "@" in proxy_addr:
        proxy_addr = proxy_addr.split("@", 1)[1]

    # Check exact matches
    if proxy_addr in BAD_PROXIES or proxy_addr in HIGH_FAILURE_PROXIES:
        return True

    # Check subnet matches
    for subnet in BAD_SUBNETS:
        if proxy_addr.startswith(subnet):
            return True

    return False

def main():
    if len(sys.argv) < 2:
        print("Usage: python clean_proxies.py <proxy_file> [output_file]")
        print("Example: python clean_proxies.py proxies.txt proxies_clean.txt")
        sys.exit(1)

    input_file = Path(sys.argv[1])
    output_file = Path(sys.argv[2]) if len(sys.argv) > 2 else input_file.with_suffix(".clean.txt")

    if not input_file.exists():
        print(f"Error: {input_file} not found")
        sys.exit(1)

    # Read all proxies
    lines = input_file.read_text(encoding="utf-8").strip().splitlines()
    print(f"Read {len(lines)} proxies from {input_file}")

    # Filter
    kept = []
    removed = []
    for line in lines:
        if not line.strip() or line.strip().startswith("#"):
            continue
        if should_remove_proxy(line):
            removed.append(line)
        else:
            kept.append(line)

    print(f"\nRemoved {len(removed)} bad proxies:")
    for proxy in removed:
        print(f"  - {proxy}")

    print(f"\nKeeping {len(kept)} proxies")

    # Write output
    output_file.write_text("\n".join(kept) + "\n", encoding="utf-8")
    print(f"\nSaved cleaned list to {output_file}")

    if len(removed) > 0:
        print(f"\n💡 Tip: You saved ~{len(removed) * 60 // 60} minutes of timeout delays per request cycle")

if __name__ == "__main__":
    main()
