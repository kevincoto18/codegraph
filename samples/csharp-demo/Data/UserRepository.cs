using System.Collections.Generic;
using Demo.Models;

namespace Demo.Data
{
    /// <summary>Keeps users in memory.</summary>
    public class UserRepository : IRepository
    {
        private readonly List<User> _users = new();

        public int Count => _users.Count;

        public void Save(User user)
        {
            Validate(user);
            _users.Add(user);
            Log.Info("saved " + user.Display());
        }

        private static void Validate(User user)
        {
            if (string.IsNullOrEmpty(user.Name))
            {
                throw new System.ArgumentException("empty name");
            }
        }
    }
}
