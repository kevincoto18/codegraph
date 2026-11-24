package storage

import "example.com/godemo/internal/model"

// Repo stores users.
type Repo interface {
	Save(user model.User) error
}

// MemoryRepo keeps users in memory.
type MemoryRepo struct {
	base
	users []model.User
}

// NewMemoryRepo creates an empty repository.
func NewMemoryRepo() *MemoryRepo {
	return &MemoryRepo{base: base{prefix: "[repo] "}}
}

// Save stores a user.
func (r *MemoryRepo) Save(user model.User) error {
	r.users = append(r.users, user)
	r.log("saved " + user.Display())
	return nil
}
