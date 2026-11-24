// Package model holds the domain types.
package model

import "strings"

// User is a registered user.
type User struct {
	Name string
}

// Display returns the name in upper case.
func (u User) Display() string {
	return strings.ToUpper(u.Name)
}
