"""The local HTTP contract can be checked without downloading or importing the model."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("local_icons", Path(__file__).parents[1] / "scripts/local-icons.py")
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)


class LocalIconServiceTest(unittest.TestCase):
    def test_long_settings_do_not_push_out_tone_and_character_appearance(self):
        class Words:
            def encode(self, text, **_kwargs):
                return text.split()

            def decode(self, tokens):
                return " ".join(tokens)

        theme = "Ancient forest " + "old trees " * 100 + "\nNoir watercolor\nCopper and blue glass"
        result = icons.compact_theme(theme, Words())
        self.assertIn("Ancient forest", result)
        self.assertIn("Noir watercolor", result)
        self.assertIn("Copper and blue glass", result)
        self.assertLessEqual(len(result.replace(";", "").split()), 48)

    def test_request_validation_and_failure_recovery(self):
        received = []

        def generate(subject):
            received.append(subject)
            if subject["seed"] == 0:
                raise RuntimeError("private details")
            return b"generated-png"

        server = icons.create_server(generate, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        subject = {"name": "Fireball", "kind": "combat", "description": "A flame", "seed": 42}

        def post(data, headers=None):
            return urllib.request.urlopen(urllib.request.Request(
                url + "/generate", data=json.dumps(data).encode(),
                headers=headers if headers is not None else {"X-Gather-Icons": "1"},
            ))

        try:
            self.assertEqual(json.load(urllib.request.urlopen(url + "/health")), {"ready": True})
            for data, headers, status in [
                (subject, {}, 403),
                (subject, {"X-Gather-Icons": "1", "Origin": "https://example.com"}, 403),
                ({**subject, "name": []}, None, 400),
                ({**subject, "seed": True}, None, 400),
                ({**subject, "extra": "prompt"}, None, 400),
                ({**subject, "theme": []}, None, 400),
                ({**subject, "theme": "x" * 2401}, None, 400),
                ({**subject, "ability": []}, None, 400),
                ({**subject, "ability": {"effect": "unknown", "targeting": "single", "inflicts": None, "cures": []}}, None, 400),
                ({**subject, "ability": {"effect": "strike", "targeting": "area", "inflicts": [], "cures": []}}, None, 400),
                ({**subject, "seed": 0}, None, 503),
            ]:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    post(data, headers)
                self.assertEqual(error.exception.code, status)
                self.assertNotIn(b"private details", error.exception.read())
            with post(subject) as response:
                self.assertEqual(response.headers["Content-Type"], "image/png")
                self.assertEqual(response.read(), b"generated-png")
            self.assertEqual(received[-1], subject)
            themed = {**subject, "theme": "A frost-powered mechanical guardian, blue ice and steel", "ability": {
                "effect": "strike", "targeting": "area", "inflicts": "Frozen", "cures": [],
            }}
            with post(themed) as response:
                self.assertEqual(response.status, 200)
            self.assertEqual(received[-1], themed)
            prompt = icons.icon_prompt({**themed, "art": {
                "motif": "a radiating energy ring", "palette": "icy blue and silver",
                "materials": "frosted steel", "style": "crystalline mechanical geometry",
            }})
            self.assertIn("radiating energy ring", prompt)
            self.assertIn("icy blue and silver", prompt)
            self.assertNotIn("Fireball", prompt)
            self.assertNotIn("A flame", prompt)
            self.assertNotIn(themed["theme"], prompt)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
