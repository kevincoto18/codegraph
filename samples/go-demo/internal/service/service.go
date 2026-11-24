// Package service registers users.
package service

import (
	"errors"

	"example.com/godemo/internal/model"
	"example.com/godemo/internal/storage"
)

// Service registers users in a repository.
type Service struct {
	repo storage.Repo
}

// New creates a service.
func New(repo storage.Repo) *Service {
	return &Service{repo: repo}
}

// Register validates and stores a user.
func (s *Service) Register(name string) error {
	if name == "" {
		return errors.New("empty name")
	}
	user := model.User{Name: name}
	s.notify(user)
	return s.repo.Save(user)
}

func (s *Service) notify(user model.User) {
	_ = user.Display()
}
