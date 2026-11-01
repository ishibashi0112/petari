Namespace Contract
    Public Class PartsService
        Implements IPartsApi
        Public Function Search(req As PartsSearchRequest) As PartsSearchResponse Implements IPartsApi.Search
            Return New PartsSearchResponse()
        End Function
    End Class
End Namespace
