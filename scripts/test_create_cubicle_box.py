import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("provision", Path(__file__).with_name("create-cubicle-box.py"))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTests(unittest.TestCase):
    def test_discovery_preserves_include_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            original = "Include ~/.ssh/cubicle_config\nHost unrelated\n  User other\n"
            config.write_text(original)
            provision.discover_alias(config, "ateam-demo")
            provision.discover_alias(config, "ateam-demo")
            self.assertTrue(config.read_text().startswith(original))
            self.assertEqual(config.read_text().count("Host ateam-demo\n"), 1)

    def test_rejects_ssh_options_and_shell_metacharacters(self):
        for value in ("-oProxyCommand=bad", "a;id", "a/b", "a\nb", "a ", "a'", "a" * 64):
            with self.subTest(value=value), self.assertRaises(Exception):
                provision.label(value)


if __name__ == "__main__":
    unittest.main()
