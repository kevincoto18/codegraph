"""Configuration loading."""


def load():
    return _read("settings.toml")


def _read(path):
    return {"path": path}
