"""Users."""
from ..utils import slugify
from app import config


class UserService:
    @staticmethod
    def create(name):
        return UserService()._save(slugify(name))

    def _save(self, slug):
        self.validate(slug)
        settings = config.load()
        return settings

    def validate(self, slug):
        def check(value):
            return len(value) > 0

        return check(slug)
