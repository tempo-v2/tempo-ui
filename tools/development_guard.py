"""Protect the managed Tempo installation from local build and server commands."""

import os
from pathlib import Path
import plistlib
import pwd
import re
import socket
import subprocess
import sys

LABEL = "com.tempo-v2.usable-release"
RELEASE = Path(".local/usable-release")
SQLITE_SUFFIXES = ("", "-wal", "-shm", "-journal")


def identity(path):
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    return info.st_dev, info.st_ino


def contains(directory, path):
    """Compare existing ancestors by inode, including case aliases on APFS."""
    resolved_directory = directory.resolve()
    resolved_path = path.resolve()
    inode = identity(resolved_directory)
    # Check the registered path spelling too. A build can remove a symlink
    # needed by an installed path even when its target is safely elsewhere.
    return any(
        parent in (directory, resolved_directory)
        or (inode is not None and identity(parent) == inode)
        for parent in (path, *path.parents, resolved_path, *resolved_path.parents)
    )


def server_resources(args):
    if not isinstance(args, list) or len(args) != 5 or args[1] != "serve":
        raise ValueError("Unrecognized managed Tempo ProgramArguments")
    backend, _, database, ui, port = args
    paths = tuple(Path(value) for value in (backend, database, ui))
    if not all(path.is_absolute() for path in paths) or not 1 <= int(port) <= 65535:
        raise ValueError("Invalid managed Tempo resources")
    return *paths, int(port)


def plist_resources(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    with path.open("rb") as source:
        job = plistlib.load(source)
    if job.get("Label") != LABEL:
        raise ValueError(f"Unexpected managed job label in {path}")
    resources = server_resources(job.get("ProgramArguments"))
    program = job.get("Program")
    if program is not None:
        if not Path(program).is_absolute():
            raise ValueError(f"Invalid managed job executable in {path}")
        return resources, Path(program)
    return resources, resources[0]


def loaded_resources():
    domain = f"gui/{os.getuid()}"
    result = subprocess.run(
        ["/bin/launchctl", "print", f"{domain}/{LABEL}"],
        capture_output=True, text=True,
    )
    if result.returncode == 113 and (
        f'Could not find service "{LABEL}" in domain for user gui: {os.getuid()}'
        in result.stderr.splitlines()
    ):
        return None
    if result.returncode:
        raise ValueError(f"Cannot inspect the managed Tempo job: {result.stderr.strip()}")
    match = re.search(r"^\s*arguments = \{\n(.*?)^\s*\}", result.stdout, re.M | re.S)
    program = re.search(r"^\s*program = (.+)$", result.stdout, re.M)
    plist = re.search(r"^\s*path = (.+)$", result.stdout, re.M)
    if not match or not program or not plist:
        raise ValueError("Cannot read the managed Tempo job arguments")
    executable, config = map(Path, (program[1], plist[1]))
    if not executable.is_absolute() or not config.is_absolute():
        raise ValueError("Cannot identify the managed Tempo executable and registration")
    return server_resources([line.strip() for line in match[1].splitlines()]), executable, config


def database_files(path):
    return [Path(f"{path}{suffix}") for suffix in SQLITE_SUFFIXES]


class Installation:
    def __init__(self, workspace):
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
        canonical = home / "Developer/tempo-v2" / RELEASE
        local = workspace / RELEASE
        self.paths = {canonical, local}
        self.ports = set()
        self.ui = set()
        if sys.platform != "darwin":
            return
        configs = {
            canonical / f"{LABEL}.plist", local / f"{LABEL}.plist",
            home / f"Library/LaunchAgents/{LABEL}.plist",
        }
        running = loaded_resources()
        if running:
            args, program, config = running
            self.add(args, program)
            configs.add(config)
        for config in configs:
            # Reserve the registration path even while the job is unloaded.
            self.paths.add(config)
            registered = plist_resources(config)
            if registered:
                self.add(*registered)

    def add(self, resources, program):
        backend, database, ui, port = resources
        database_paths = database_files(database) + database_files(database.resolve())
        self.paths.update([backend, program, *database_paths, ui])
        self.ui.add(ui)
        self.ports.add(port)

    def check(self, path, *, output=False):
        if any(
            contains(protected, path) or (output and contains(path, protected))
            for protected in self.paths
        ):
            raise ValueError(f"Development path overlaps the managed installation: {path}")

    def check_cargo_output(self, directory):
        self.check(directory, output=True)
        managed_files = self.paths - self.ui
        for ui in self.ui:
            managed_files = managed_files | {entry for entry in ui.rglob("*") if entry.is_file()}
        managed_inodes = {identity(path) for path in managed_files} - {None}

        def fail(error):
            raise error

        # Cargo can reuse existing files and descend into existing output directories.
        if identity(directory) is not None:
            for root, dirs, files in os.walk(directory, onerror=fail):
                for name in dirs + files:
                    entry = Path(root) / name
                    info = entry.lstat()
                    if entry.is_symlink() and not contains(directory, entry.resolve()):
                        raise ValueError(f"Cargo output link leaves its target directory: {entry}")
                    if info.st_nlink > 1 and (info.st_dev, info.st_ino) in managed_inodes:
                        raise ValueError(f"Cargo output aliases a managed file: {entry}")

    def check_port(self, port):
        if not 1 <= port <= 65535:
            raise ValueError("TEMPO_PORT must be between 1 and 65535")
        if port in self.ports:
            raise ValueError(f"Port {port} is reserved for the managed installation")
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                probe.listen()
            except OSError as error:
                raise ValueError(f"Development port {port} is unavailable: {error}") from error


def check_ui(installation, source):
    installation.check(source / "dist", output=True)
    installation.check(source / "node_modules", output=True)


if __name__ == "__main__":
    try:
        source = Path.cwd().resolve()
        check_ui(Installation(source.parent), source)
    except (OSError, RuntimeError, ValueError, TypeError) as error:
        sys.exit(f"Tempo development preflight: {error}")
