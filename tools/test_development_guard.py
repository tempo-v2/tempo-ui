"""Focused tests for managed resources in development preflight."""

import os
from pathlib import Path
import plistlib
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import development_guard as guard


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "worktree"
        self.release = self.workspace / guard.RELEASE
        self.release.mkdir(parents=True)
        self.plist = self.release / f"{guard.LABEL}.plist"
        self.backend = self.release / "backend"
        self.db = self.release / "study.sqlite"
        self.ui = self.release / "ui"
        self.backend.touch()
        self.db.touch()
        self.ui.mkdir()
        self.port = 41822
        self.write_registration()
        platform = patch.object(guard.sys, "platform", "darwin")
        loaded = patch.object(guard, "loaded_resources", return_value=None)
        for patcher in (platform, loaded):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_registration(self):
        with self.plist.open("wb") as sink:
            plistlib.dump({
                "Label": guard.LABEL,
                "ProgramArguments": [
                    str(self.backend), "serve", str(self.db), str(self.ui), str(self.port),
                ],
            }, sink)

    def test_unloaded_job_protects_database_and_aliases(self):
        installation = guard.Installation(self.workspace)
        link = self.root / "link.sqlite"
        link.symlink_to(self.db)
        hardlink = self.root / "hardlink.sqlite"
        os.link(self.db, hardlink)
        parent = self.root / "alias"
        parent.symlink_to(self.release)
        for path in (self.db, link, hardlink, parent / "absent/nested.sqlite"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "overlaps"):
                installation.check(path)
        with self.assertRaisesRegex(ValueError, "reserved"):
            installation.check_port(self.port)

    def test_unreadable_or_dangling_registration_fails_closed(self):
        self.plist.write_text("broken plist")
        with self.assertRaises(plistlib.InvalidFileException):
            guard.Installation(self.workspace)
        self.plist.unlink()
        self.plist.symlink_to(self.release / "missing.plist")
        with self.assertRaises(FileNotFoundError):
            guard.Installation(self.workspace)

    def test_output_preserves_symlink_used_by_managed_ui(self):
        ui_source = self.workspace / "tempo-ui"
        output = ui_source / "dist"
        output.mkdir(parents=True)
        link = output / "managed"
        link.symlink_to(self.ui)
        self.ui = link
        self.write_registration()
        with self.assertRaisesRegex(ValueError, "overlaps"):
            guard.check_ui(guard.Installation(self.workspace), ui_source)

    def test_output_rejects_cargo_link_to_backend(self):
        target = self.root / "target"
        target.mkdir()
        installation = guard.Installation(self.workspace)
        link = target / "link"
        link.symlink_to(self.backend)
        with self.assertRaisesRegex(ValueError, "leaves its target directory"):
            installation.check_cargo_output(target)
        link.unlink()
        os.link(self.backend, link)
        with self.assertRaisesRegex(ValueError, "aliases"):
            installation.check_cargo_output(target)


class LaunchctlTests(unittest.TestCase):
    def test_inspection_failure_is_distinct_from_absent_service(self):
        absence = f'Could not find service "{guard.LABEL}" in domain for user gui: {os.getuid()}\n'
        results = [
            subprocess.CompletedProcess([], 113, "", absence),
            subprocess.CompletedProcess([], 113, "", "Permission denied"),
            subprocess.CompletedProcess([], 0, "unrecognized success format", ""),
        ]
        with patch.object(guard.subprocess, "run", side_effect=results):
            self.assertIsNone(guard.loaded_resources())
            with self.assertRaisesRegex(ValueError, "Cannot inspect"):
                guard.loaded_resources()
            with self.assertRaisesRegex(ValueError, "Cannot read"):
                guard.loaded_resources()


if __name__ == "__main__":
    unittest.main()
