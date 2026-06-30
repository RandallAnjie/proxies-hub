from __future__ import annotations

import argparse
import os

from .config import Config
from .server import run


def main():
    ap = argparse.ArgumentParser(prog="proxyhub")
    ap.add_argument("-c", "--config", default=os.environ.get("PROXYHUB_CONFIG", "config.yaml"))
    args = ap.parse_args()
    run(Config.load(args.config))


if __name__ == "__main__":
    main()
