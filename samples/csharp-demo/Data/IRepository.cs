using Demo.Models;

namespace Demo.Data
{
    /// <summary>Stores users.</summary>
    public interface IRepository
    {
        void Save(User user);
    }
}
