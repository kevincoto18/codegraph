using Demo.Data;
using Demo.Models;

namespace Demo.Services;

/// <summary>Registers users.</summary>
public class UserService
{
    private readonly IRepository _repository;

    public UserService(IRepository repository)
    {
        _repository = repository;
    }

    public void Register(string name)
    {
        var user = new User(name);
        _repository.Save(user);
        Notify(user);
    }

    private void Notify(User user) => Log.Info("registered " + user.Display());
}
