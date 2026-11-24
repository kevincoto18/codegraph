using Demo.Data;
using Demo.Services;

namespace Demo
{
    /// <summary>Entry point of the demo.</summary>
    public static class Program
    {
        public static void Main()
        {
            var repository = new UserRepository();
            var service = new UserService(repository);
            service.Register("ana");
            Log.Info($"users: {repository.Count}");
        }
    }
}
