namespace Demo;

/// <summary>Minimal console logger.</summary>
public static class Log
{
    public static void Info(string message) => Write("INFO " + message);

    private static void Write(string line)
    {
        System.Console.WriteLine(line);
    }
}
