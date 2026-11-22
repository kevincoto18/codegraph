"""Entry point."""
import os
from app.services.user_service import UserService
from .utils import slugify, normalize as norm
from . import config


def main():
    config.load()
    UserService.create(slugify(os.getcwd()))
    return norm("Demo")
